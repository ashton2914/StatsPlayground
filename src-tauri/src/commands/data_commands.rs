use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::{State,Emitter};
use crate::models::project_persistence::{ProjectWriteContext,ProjectMutationResult};

use crate::error::AppError;
use crate::models::table::{
    CellPosition, CellUpdate, ColumnDescriptor, ColumnDisplayProps, ColumnMutationResult,
    CreateManagedTableRequest, CreateTableFromRowsRequest, DatasetMeta, ManagedTableCreateResult,
    RowMutationResult, TableFilterValue, TableNavigationBenchmarkFixture,
    TableNavigationBenchmarkRequest, TableNavigationRequest, TableNavigationResult,
    TableQueryResult, TableQuerySessionRequest, TableQuerySessionStatus, TableWindowRequest,
    TableWindowResult,
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

pub(crate) fn add_rows_entry(
    state: &AppState,
    dataset_id: &str,
    count: usize,
    before_row_id: Option<i64>,
    expected_generation: u64,
) -> Result<RowMutationResult, AppError> {
    DataService::new(state).add_rows(dataset_id, count, before_row_id, expected_generation)
}

pub(crate) fn delete_rows_with_change_set_entry(
    state: &AppState,
    dataset_id: &str,
    row_ids: &[i64],
    expected_generation: u64,
) -> Result<RowMutationResult, AppError> {
    DataService::new(state).delete_rows_with_change_set(dataset_id, row_ids, expected_generation)
}

pub(crate) fn add_columns_with_change_set_entry(
    state: &AppState,
    dataset_id: &str,
    columns: &[ColumnDescriptor],
    at_index: Option<i32>,
    expected_generation: u64,
) -> Result<ColumnMutationResult, AppError> {
    DataService::new(state).add_columns_with_change_set(
        dataset_id,
        columns,
        at_index,
        expected_generation,
    )
}

pub(crate) fn delete_columns_with_change_set_entry(
    state: &AppState,
    dataset_id: &str,
    columns: &[ColumnDescriptor],
    expected_generation: u64,
) -> Result<ColumnMutationResult, AppError> {
    DataService::new(state).delete_columns_with_change_set(dataset_id, columns, expected_generation)
}

pub(crate) fn query_table_window_entry(
    state: &AppState,
    request: &TableWindowRequest,
) -> Result<TableWindowResult, AppError> {
    #[cfg(all(feature="project-v5",feature="perf-harness"))]
    let span=crate::perf_project_v5_ui::query_span(state,&request.dataset_id,None);
    let result=DataService::new(state).query_table_window(request);
    #[cfg(all(feature="project-v5",feature="perf-harness"))]
    crate::perf_project_v5_ui::finish_span(span,&result);
    result
}

pub(crate) fn query_table_navigation_window_entry(
    state: &AppState,
    request: &TableNavigationRequest,
) -> Result<TableNavigationResult, AppError> {
    let service = DataService::new(state);
    #[cfg(all(feature="project-v5",feature="perf-harness"))]
    let span=crate::perf_project_v5_ui::query_span(state,&request.dataset_id,Some(&request.request_id));
    let mut result=service.query_table_navigation_window(request)?;
    if request.include_transport_diagnostics {
        let encode_started = Instant::now();
        let _ = serde_json::to_vec(&result)
            .map_err(|error| AppError::InvalidParam(error.to_string()))?;
        result.timings.diagnostic_json_encode_ms = Some(
            u64::try_from(encode_started.elapsed().as_millis()).map_err(|_| {
                AppError::Database("table navigation encode proxy timing overflowed".into())
            })?,
        );
        result.timings.diagnostic_response_ready_at_epoch_ms = Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| AppError::Database(error.to_string()))?
                .as_millis()
                .try_into()
                .map_err(|_| {
                    AppError::Database("table navigation response timestamp overflowed".into())
                })?,
        );
        result.timings.diagnostic_json_bytes =
            Some(compute_navigation_response_bytes(&mut result)?);
    }
    let result=Ok(result);
    #[cfg(all(feature="project-v5",feature="perf-harness"))]
    crate::perf_project_v5_ui::finish_span(span,&result);
    result
}

fn compute_navigation_response_bytes(result: &mut TableNavigationResult) -> Result<u64, AppError> {
    result.timings.diagnostic_json_bytes = Some(0);
    let mut previous = 0u64;
    for _ in 0..4 {
        let encoded = serde_json::to_vec(result)
            .map_err(|error| AppError::InvalidParam(error.to_string()))?;
        let encoded_len = u64::try_from(encoded.len())
            .map_err(|_| AppError::Database("table navigation payload is too large".into()))?;
        if encoded_len == previous {
            return Ok(encoded_len);
        }
        previous = encoded_len;
        result.timings.diagnostic_json_bytes = Some(encoded_len);
    }
    Ok(previous)
}

#[cfg(any(test, feature = "perf-harness"))]
#[tauri::command(async)]
pub fn prepare_table_navigation_benchmark(
    state: State<'_, AppState>,
    request: TableNavigationBenchmarkRequest,
) -> Result<TableNavigationBenchmarkFixture, AppError> {
    let service = DataService::new(&state);
    service.prepare_table_navigation_benchmark(&request)
}

#[cfg(not(any(test, feature = "perf-harness")))]
#[tauri::command(async)]
pub fn prepare_table_navigation_benchmark(
    _state: State<'_, AppState>,
    _request: TableNavigationBenchmarkRequest,
) -> Result<TableNavigationBenchmarkFixture, AppError> {
    Err(AppError::InvalidParam(
        "table navigation benchmark is unavailable in production builds".into(),
    ))
}

#[tauri::command(async)]
pub fn import_file(app:tauri::AppHandle,state: State<'_, AppState>, file_path: String,context:Option<ProjectWriteContext>) -> Result<ProjectMutationResult<DatasetMeta>, AppError> {
    if let Some(context) = context {
        let commit = crate::services::project_native_service::NativeProjectService::new(&state).import_file(&context,&file_path)?;
        if app.emit("project-committed",&commit).is_err() { eprintln!("project_commit_event_delivery_failed"); }
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.import_csv(&file_path).map(ProjectMutationResult::Legacy)
}

#[tauri::command]
pub fn list_datasets(state: State<'_, AppState>) -> Result<Vec<DatasetMeta>, AppError> {
    let service = DataService::new(&state);
    service.list_datasets()
}

#[tauri::command(async)]
pub fn delete_dataset(app:tauri::AppHandle,state: State<'_, AppState>, dataset_id: String,context:Option<ProjectWriteContext>) -> Result<ProjectMutationResult<()>, AppError> {
    if let Some(context) = context {
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).delete_dataset(&context,&dataset_id)?;
        if app.emit("project-committed",&commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
        return Ok(ProjectMutationResult::Committed(commit));
    }
    delete_dataset_entry(state.inner(), &dataset_id).map(ProjectMutationResult::Legacy)
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

#[tauri::command(async)]
pub fn query_table_navigation_window(
    state: State<'_, AppState>,
    request: TableNavigationRequest,
) -> Result<TableNavigationResult, AppError> {
    query_table_navigation_window_entry(state.inner(), &request)
}

#[tauri::command(async)]
pub fn query_table_navigation_row_ids(state:State<'_,AppState>,request:TableNavigationRequest) -> Result<TableNavigationResult,AppError> {
    DataService::new(&state).query_table_navigation_row_ids(&request)
}

#[tauri::command(async)]
pub fn prepare_table_query_session(
    state: State<'_, AppState>,
    request: TableQuerySessionRequest,
) -> Result<TableQuerySessionStatus, AppError> {
    let service = DataService::new(&state);
    service.prepare_table_query_session(&request)
}

#[tauri::command(async)]
pub fn get_table_query_session_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<TableQuerySessionStatus, AppError> {
    let service = DataService::new(&state);
    service.get_table_query_session_status(&session_id)
}

#[tauri::command(async)]
pub fn release_table_query_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    let service = DataService::new(&state);
    service.release_table_query_session(&session_id)
}

#[tauri::command(async)]
pub fn cancel_table_navigation_request(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), AppError> {
    let service = DataService::new(&state);
    service.cancel_table_navigation_request(&request_id)
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
) -> Result<Vec<TableFilterValue>, AppError> {
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

#[tauri::command(async)]
pub fn create_table_from_sql_query(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    sql: String,
    name: String,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<DatasetMeta>, AppError> {
    if let Some(context) = context {
        let commit = crate::services::project_native_service::NativeProjectService::new(&state).materialize_sql(&context,&sql,&name)?;
        if app.emit("project-committed",&commit).is_err() { eprintln!("project_commit_event_delivery_failed"); }
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.create_table_from_sql_query(&sql, &name).map(ProjectMutationResult::Legacy)
}

#[tauri::command]
pub fn preflight_create_table_from_sql_query(
    state: State<'_, AppState>,
    sql: String,
    name: String,
) -> Result<(), AppError> {
    let service = DataService::new(&state);
    service.preflight_create_table_from_sql_query(&sql, &name)
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

#[tauri::command(async)]
pub fn create_table_from_rows(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    request: CreateTableFromRowsRequest,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<DatasetMeta>, AppError> {
    if let Some(context) = context {
        let commit = crate::services::project_native_service::NativeProjectService::new(&state).create_table_from_rows(&context,&request)?;
        if app.emit("project-committed",&commit).is_err() { eprintln!("project_commit_event_delivery_failed"); }
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.create_table_from_rows(&request).map(ProjectMutationResult::Legacy)
}

#[tauri::command(async)]
pub fn create_managed_table(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    request: CreateManagedTableRequest,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<ManagedTableCreateResult>, AppError> {
    if let Some(context) = context {
        let commit = crate::services::project_native_service::NativeProjectService::new(&state).create_managed_table(&context,&request)?;
        if app.emit("project-committed",&commit).is_err() { eprintln!("project_commit_event_delivery_failed"); }
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.create_managed_table_outcome(&request).map(ProjectMutationResult::Legacy)
}

#[tauri::command]
pub fn add_row(state: State<'_, AppState>, dataset_id: String) -> Result<i64, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.add_row(&dataset_id)
}

#[tauri::command(async)]
pub fn add_rows(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
    count: usize,
    before_row_id: Option<i64>,
    expected_generation: u64,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<RowMutationResult>, AppError> {
    if let Some(context) = context {
        let commit = crate::services::project_native_service::NativeProjectService::new(&state).add_rows(&context,&dataset_id,count,before_row_id,expected_generation)?;
        if app.emit("project-committed",&commit).is_err() { eprintln!("project_commit_event_delivery_failed"); }
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    add_rows_entry(state.inner(),&dataset_id,count,before_row_id,expected_generation).map(ProjectMutationResult::Legacy)
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

#[tauri::command(async)]
pub fn clear_cells(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
    cells: Vec<CellPosition>,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<()>, AppError> {
    if let Some(context) = context {
        let commit = crate::services::project_native_service::NativeProjectService::new(&state).clear_cells(&context,&dataset_id,&cells)?;
        if app.emit("project-committed",&commit).is_err() { eprintln!("project_commit_event_delivery_failed"); }
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.clear_cells(&dataset_id, &cells).map(ProjectMutationResult::Legacy)
}

#[tauri::command(async)]
pub fn update_cells(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
    updates: Vec<CellUpdate>,
    expected_generation: Option<u64>,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<u64>, AppError> {
    if let Some(context) = context {
        let commit = crate::services::project_native_service::NativeProjectService::new(&state).update_cells(&context,&dataset_id,&updates,expected_generation)?;
        if app.emit("project-committed",&commit).is_err() { eprintln!("project_commit_event_delivery_failed"); }
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.update_cells(&dataset_id, &updates, expected_generation).map(ProjectMutationResult::Legacy)
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

#[tauri::command(async)]
pub fn delete_rows_with_change_set(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
    row_ids: Vec<i64>,
    expected_generation: u64,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<RowMutationResult>, AppError> {
    if let Some(context) = context {
        let commit = crate::services::project_native_service::NativeProjectService::new(&state).delete_rows(&context,&dataset_id,&row_ids,expected_generation)?;
        if app.emit("project-committed",&commit).is_err() { eprintln!("project_commit_event_delivery_failed"); }
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    delete_rows_with_change_set_entry(state.inner(), &dataset_id, &row_ids, expected_generation).map(ProjectMutationResult::Legacy)
}

#[tauri::command(async)]
pub fn delete_columns_with_change_set(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
    columns: Vec<ColumnDescriptor>,
    expected_generation: u64,
    context: Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<ColumnMutationResult>, AppError> {
    if let Some(context) = context {
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).delete_columns(&context,&dataset_id,&columns,expected_generation)?;
        if app.emit("project-committed",&commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    delete_columns_with_change_set_entry(state.inner(), &dataset_id, &columns, expected_generation).map(ProjectMutationResult::Legacy)
}

#[tauri::command(async)]
// Preserve the flat Tauri IPC arguments while adding native ownership context.
#[allow(clippy::too_many_arguments)]
pub fn alter_column_with_change_set(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
    old_name: String,
    new_name: String,
    new_type: String,
    expected_generation: Option<u64>,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<String>, AppError> {
    if let Some(context) = context {
        let generation=expected_generation.or_else(||context.dataset_generations.iter().find(|item|item.id==dataset_id).map(|item|item.generation)).ok_or_else(||AppError::InvalidParam("project_dataset_precondition_required".into()))?;
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).alter_column(&context,&dataset_id,&old_name,&new_name,&new_type,generation)?;
        if app.emit("project-committed",&commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.alter_column_with_change_set(
        &dataset_id,
        &old_name,
        &new_name,
        &new_type,
        expected_generation,
    ).map(ProjectMutationResult::Legacy)
}

#[tauri::command(async)]
pub fn alter_columns_type_with_change_set(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
    column_names: Vec<String>,
    new_type: String,
    expected_generation: Option<u64>,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<String>, AppError> {
    if let Some(context) = context {
        let generation=expected_generation.or_else(||context.dataset_generations.iter().find(|item|item.id==dataset_id).map(|item|item.generation)).ok_or_else(||AppError::InvalidParam("project_dataset_precondition_required".into()))?;
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).alter_column_types(&context,&dataset_id,&column_names,&new_type,generation)?;
        if app.emit("project-committed",&commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.alter_columns_type_with_change_set(
        &dataset_id,
        &column_names,
        &new_type,
        expected_generation,
    ).map(ProjectMutationResult::Legacy)
}

#[tauri::command(async)]
pub fn rename_dataset(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
    new_name: String,
    context: Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<()>, AppError> {
    if let Some(context) = context {
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).rename_dataset(&context,&dataset_id,&new_name)?;
        if app.emit("project-committed",&commit).is_err() { eprintln!("project_commit_event_delivery_failed"); }
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.rename_dataset(&dataset_id, &new_name).map(ProjectMutationResult::Legacy)
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

#[tauri::command(async)]
pub fn add_columns_with_change_set(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
    columns: Vec<ColumnDescriptor>,
    at_index: Option<i32>,
    expected_generation: u64,
    context: Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<ColumnMutationResult>, AppError> {
    if let Some(context) = context {
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).add_columns(&context,&dataset_id,&columns,at_index,expected_generation)?;
        if app.emit("project-committed",&commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    add_columns_with_change_set_entry(
        state.inner(),
        &dataset_id,
        &columns,
        at_index,
        expected_generation,
    ).map(ProjectMutationResult::Legacy)
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

#[tauri::command(async)]
pub fn reorder_column_if_generation(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
    from: usize,
    to: usize,
    expected_generation: u64,
    context: Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<u64>, AppError> {
    if let Some(context) = context {
        let from=i32::try_from(from).map_err(|_|AppError::InvalidParam("column index is too large".into()))?;
        let to=i32::try_from(to).map_err(|_|AppError::InvalidParam("column index is too large".into()))?;
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).reorder_columns(&context,&dataset_id,from,to,expected_generation)?;
        if app.emit("project-committed",&commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = DataService::new(&state);
    service.reorder_column_if_generation(&dataset_id, from, to, expected_generation).map(ProjectMutationResult::Legacy)
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

#[tauri::command(async)]
// Preserve the flat Tauri IPC arguments while adding native ownership context.
#[allow(clippy::too_many_arguments)]
pub fn paste_at_position_with_change_set(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    dataset_id: String,
    start_row: usize,
    start_col: usize,
    rows: Vec<Vec<String>>,
    header_names: Option<Vec<String>>,
    col_types: Vec<String>,
    expected_generation: Option<u64>,
    row_ids:Option<Vec<i64>>,
    column_ids:Option<Vec<String>>,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<crate::models::table::PasteChangeSetResult>, AppError> {
    if let Some(context) = context {
        let expected_generation=expected_generation.or_else(||context.dataset_generations.iter().find(|item|item.id==dataset_id).map(|item|item.generation)).ok_or_else(||AppError::InvalidParam("project_dataset_precondition_required".into()))?;
        let request=crate::models::project_persistence::ProjectPasteRequest{dataset_id,start_row,start_col,rows,header_names,col_types,expected_generation,row_ids,column_ids:column_ids.ok_or_else(||AppError::InvalidParam("project_columns_required".into()))?};
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).paste(&context,&request)?;
        if app.emit("project-committed",&commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
        return Ok(ProjectMutationResult::Committed(commit));
    }
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
    Ok(ProjectMutationResult::Legacy(crate::models::table::PasteChangeSetResult { change_set_id,generation:None,row_count:None,column_count:None }))
}

#[tauri::command(async)]
pub fn apply_table_change_set(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    change_set_id: String,
    undo: bool,
    dataset_id:Option<String>,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<()>, AppError> {
    if let Some(context) = context {
        let dataset_id=dataset_id.ok_or_else(||AppError::InvalidParam("project_history_dataset_required".into()))?;
        let commit = crate::services::project_native_service::NativeProjectService::new(&state).apply_change_set(&context,&dataset_id,&change_set_id,undo)?;
        if app.emit("project-committed",&commit).is_err() { eprintln!("project_commit_event_delivery_failed"); }
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    DataService::new(&state).apply_change_set(&change_set_id, undo).map(ProjectMutationResult::Legacy)
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
    epoch:Option<u64>,
) -> Result<Vec<ColumnDisplayProps>, AppError> {
    if let Some(epoch)=epoch { return crate::services::project_native_service::NativeProjectService::new(&state).column_display_props(epoch,&dataset_id); }
    if state.project_database.read().map_err(|error|AppError::Database(error.to_string()))?.is_some() { return Err(AppError::InvalidParam("project_epoch_required".into())); }
    let display = state
        .column_display
        .lock()
        .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(display.get(&dataset_id).cloned().unwrap_or_default())
}

#[tauri::command(async)]
pub fn set_column_display_props(
    state: State<'_, AppState>,
    dataset_id: String,
    props: Vec<ColumnDisplayProps>,
    column_ids: Option<Vec<String>>,
    context: Option<crate::models::project_persistence::ProjectWriteContext>,
    app: tauri::AppHandle,
) -> Result<crate::models::project_persistence::ProjectMutationResult<()>, AppError> {
    if let Some(context) = context {
        let column_ids=column_ids.ok_or_else(||AppError::InvalidParam("project_column_identities_required".into()))?;
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).set_column_display_props(&context,&dataset_id,&column_ids,&props)?;
        if app.emit("project-committed",&commit).is_err() { eprintln!("project_commit_event_delivery_failed"); }
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let mut display = state
        .column_display
        .lock()
        .map_err(|e| AppError::Database(e.to_string()))?;
    display.insert(dataset_id, props);
    Ok(crate::models::project_persistence::ProjectMutationResult::Legacy(()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::models::table::{ColumnMutationResult, RowMutationResult};
    use crate::services::data_service::DataService;
    use crate::state::AppState;

    #[test]
    fn data_commands_expose_compact_mutation_contracts() {
        use crate::models::{project_persistence::{ProjectMutationResult,ProjectWriteContext},table::ColumnDescriptor};
        use crate::error::AppError;
        // Assert the public native/legacy boundary at the Rust type level.
        let _: for<'a> fn(tauri::AppHandle,tauri::State<'a,AppState>,String,usize,Option<i64>,u64,Option<ProjectWriteContext>)->Result<ProjectMutationResult<RowMutationResult>,AppError> = super::add_rows;
        let _: for<'a> fn(tauri::AppHandle,tauri::State<'a,AppState>,String,Vec<i64>,u64,Option<ProjectWriteContext>)->Result<ProjectMutationResult<RowMutationResult>,AppError> = super::delete_rows_with_change_set;
        let _: for<'a> fn(tauri::AppHandle,tauri::State<'a,AppState>,String,Vec<ColumnDescriptor>,Option<i32>,u64,Option<ProjectWriteContext>)->Result<ProjectMutationResult<ColumnMutationResult>,AppError> = super::add_columns_with_change_set;
        let _: for<'a> fn(tauri::AppHandle,tauri::State<'a,AppState>,String,Vec<ColumnDescriptor>,u64,Option<ProjectWriteContext>)->Result<ProjectMutationResult<ColumnMutationResult>,AppError> = super::delete_columns_with_change_set;
    }

    #[test]
    fn compact_mutation_results_serialize_with_exact_camel_case_fields() {
        let row = RowMutationResult {
            row_ids: vec![41, 42],
            generation: 8,
            row_count: 102,
            change_set_id: "rows-change".to_string(),
        };
        let legacy = crate::models::project_persistence::ProjectMutationResult::Legacy(row.clone());
        assert_eq!(serde_json::to_value(&legacy).unwrap(),serde_json::to_value(&row).unwrap(),"legacy IPC value shape must remain unchanged");
        let column = ColumnMutationResult {
            column_ids: vec!["column-new".to_string()],
            generation: 9,
            column_count: 4,
            change_set_id: "columns-change".to_string(),
        };

        assert_eq!(
            serde_json::to_value(row).expect("serialize row mutation result"),
            json!({
                "rowIds": [41, 42],
                "generation": 8,
                "rowCount": 102,
                "changeSetId": "rows-change",
            })
        );
        let legacy_column=crate::models::project_persistence::ProjectMutationResult::Legacy(column.clone());
        assert_eq!(serde_json::to_value(legacy_column).unwrap(),serde_json::to_value(&column).unwrap());
        assert_eq!(
            serde_json::to_value(column).expect("serialize column mutation result"),
            json!({
                "columnIds": ["column-new"],
                "generation": 9,
                "columnCount": 4,
                "changeSetId": "columns-change",
            })
        );
    }

    #[test]
    fn data_command_entries_route_compact_mutations_and_forward_generation() {
        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let dataset = service
            .create_table(
                "ipc-routing",
                &["first".to_string(), "second".to_string()],
                &["VARCHAR".to_string(), "INTEGER".to_string()],
            )
            .expect("dataset");

        let added_rows = super::add_rows_entry(&state, &dataset.id, 2, None, dataset.generation)
            .expect("compact row add");
        assert_eq!(added_rows.row_count, 2);
        assert_eq!(added_rows.generation, dataset.generation + 1);

        let deleted_rows = super::delete_rows_with_change_set_entry(
            &state,
            &dataset.id,
            &[added_rows.row_ids[0]],
            added_rows.generation,
        )
        .expect("compact row delete");
        assert_eq!(deleted_rows.row_count, 1);
        assert_eq!(deleted_rows.generation, added_rows.generation + 1);

        let added_descriptor = crate::models::table::ColumnDescriptor {
            column_id: uuid::Uuid::new_v4().to_string(),
            name: "third".to_string(),
            sql_type: "DOUBLE".to_string(),
            calculated: None,
        };
        let added_columns = super::add_columns_with_change_set_entry(
            &state,
            &dataset.id,
            std::slice::from_ref(&added_descriptor),
            Some(1),
            deleted_rows.generation,
        )
        .expect("compact column add");
        assert_eq!(
            added_columns.column_ids,
            vec![added_descriptor.column_id.clone()]
        );
        assert_eq!(added_columns.column_count, 3);

        let deleted_columns = super::delete_columns_with_change_set_entry(
            &state,
            &dataset.id,
            &[added_descriptor],
            added_columns.generation,
        )
        .expect("compact column delete");
        assert_eq!(deleted_columns.column_count, 2);
        assert_eq!(deleted_columns.generation, added_columns.generation + 1);

        let stale = super::add_rows_entry(&state, &dataset.id, 1, None, added_columns.generation)
            .expect_err("stale expected generation must be forwarded");
        assert!(matches!(stale, crate::error::AppError::InvalidParam(_)));
    }

    #[test]
    fn add_columns_rejects_calculated_descriptors_without_mutation() {
        use crate::models::calculated_column::{
            CalculatedColumnDescriptor, CalculatedColumnStatus, CalculatedOutputTypeV1,
        };

        let state = AppState::new().expect("state");
        let service = DataService::new(&state);
        let dataset = service
            .create_table(
                "ipc-calculated-rejection",
                &["first".to_string()],
                &["DOUBLE".to_string()],
            )
            .expect("dataset");
        let descriptor = crate::models::table::ColumnDescriptor {
            column_id: uuid::Uuid::new_v4().to_string(),
            name: "calculated".to_string(),
            sql_type: "DOUBLE".to_string(),
            calculated: Some(CalculatedColumnDescriptor {
                formula_id: uuid::Uuid::new_v4().to_string(),
                schema_version: "1".to_string(),
                output_column_id: uuid::Uuid::new_v4().to_string(),
                display_formula_text: "first * 2".to_string(),
                status: CalculatedColumnStatus::Ready,
                dependency_column_ids: Vec::new(),
                inferred_output_type: CalculatedOutputTypeV1::Continuous,
                fingerprint: "fingerprint".to_string(),
            }),
        };
        let before_columns = service
            .get_column_descriptors(&dataset.id)
            .expect("before columns");

        let error = super::add_columns_with_change_set_entry(
            &state,
            &dataset.id,
            &[descriptor],
            None,
            dataset.generation,
        )
        .expect_err("physical column addition must reject calculated descriptors");

        assert!(matches!(
            error,
            crate::error::AppError::InvalidParam(message)
                if message.contains("calculated")
        ));
        assert_eq!(
            service
                .get_dataset_generation(&dataset.id)
                .expect("generation"),
            dataset.generation
        );
        assert_eq!(
            serde_json::to_value(
                service
                    .get_column_descriptors(&dataset.id)
                    .expect("after columns")
            )
            .expect("serialize after columns"),
            serde_json::to_value(before_columns).expect("serialize before columns")
        );
    }
}
