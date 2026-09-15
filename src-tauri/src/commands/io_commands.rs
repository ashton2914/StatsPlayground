use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::models::table::DatasetMeta;
use crate::services::io_service::IoService;
use crate::state::AppState;

pub(crate) fn acquire_mutation_permit(
    state: &AppState,
) -> Result<crate::services::save_coordinator::MutationPermit<'_>, AppError> {
    state.save_coordinator.mutation_permit()
}

pub(crate) fn export_csv_entry(
    state: &AppState,
    dataset_id: &str,
    output_path: &str,
) -> Result<(), AppError> {
    let service = IoService::new(state);
    service.export_csv(dataset_id, output_path)
}

pub(crate) fn import_sqlite_entry<F>(
    state: &AppState,
    file_path: &str,
    on_progress: F,
) -> Result<Vec<DatasetMeta>, AppError>
where
    F: Fn(&str, usize, usize, usize, usize),
{
    let _permit = acquire_mutation_permit(state)?;
    let service = IoService::new(state);
    service.import_sqlite(file_path, on_progress)
}

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
    export_csv_entry(state.inner(), &dataset_id, &output_path)
}

#[tauri::command]
pub fn authorize_csv_export_root(
    state: State<'_, AppState>,
    root_path: String,
) -> Result<crate::services::path_authorization_service::OutputRootGrant, AppError> {
    let service = IoService::new(&state);
    service.authorize_output_root(&root_path)
}

#[tauri::command]
pub fn revoke_csv_export_root(
    state: State<'_, AppState>,
    root_id: String,
) -> Result<(), AppError> {
    let service = IoService::new(&state);
    service.revoke_output_root(&root_id)
}

#[tauri::command]
pub fn inspect_authorized_csv_target(
    state: State<'_, AppState>,
    dataset_id: String,
    root_id: String,
    relative_path: String,
) -> Result<crate::services::path_authorization_service::AuthorizedCsvTargetInspection, AppError> {
    let _ = dataset_id;
    let service = IoService::new(&state);
    service.inspect_authorized_csv_target(&root_id, &relative_path)
}

#[tauri::command]
pub fn export_csv_authorized(
    state: State<'_, AppState>,
    dataset_id: String,
    root_id: String,
    relative_path: String,
) -> Result<(), AppError> {
    let service = IoService::new(&state);
    service.export_csv_authorized(&dataset_id, &root_id, &relative_path)
}

#[tauri::command(async)]
pub fn import_sqlite(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
) -> Result<Vec<DatasetMeta>, AppError> {
    import_sqlite_entry(
        state.inner(),
        &file_path,
        |table_name, table_index, table_total, rows_done, rows_total| {
            let _ = app.emit(
                "import-progress",
                ImportProgress {
                    table_name: table_name.to_string(),
                    table_index,
                    table_total,
                    rows_done,
                    rows_total,
                },
            );
        },
    )
}

#[tauri::command(async)]
pub fn export_sqlite(state: State<'_, AppState>, output_path: String) -> Result<(), AppError> {
    let service = IoService::new(&state);
    service.export_sqlite(&output_path)
}

#[tauri::command(async)]
pub fn export_csv_zip(state: State<'_, AppState>, output_path: String) -> Result<(), AppError> {
    let service = IoService::new(&state);
    service.export_csv_zip(&output_path)
}

/// Folder-aware CSV ZIP export. When `dataset_ids` is `Some` only those
/// datasets are written. `archive_paths` maps `dataset_id → path inside the
/// zip` (without the `.csv` suffix) so the UI can mirror its folder tree.
#[tauri::command(async)]
pub fn export_csv_zip_subset(
    state: State<'_, AppState>,
    output_path: String,
    dataset_ids: Option<Vec<String>>,
    archive_paths: Option<HashMap<String, String>>,
) -> Result<(), AppError> {
    let service = IoService::new(&state);
    let paths = archive_paths.unwrap_or_default();
    service.export_csv_zip_subset(&output_path, dataset_ids.as_deref(), &paths)
}

/// Folder-aware SQLite export. When `dataset_ids` is `Some` only those
/// datasets are written. `name_overrides` maps `dataset_id → SQLite table
/// name`; the UI uses this to encode folder structure as `folder-table`.
#[tauri::command(async)]
pub fn export_sqlite_subset(
    state: State<'_, AppState>,
    output_path: String,
    dataset_ids: Option<Vec<String>>,
    name_overrides: Option<HashMap<String, String>>,
) -> Result<(), AppError> {
    let service = IoService::new(&state);
    let overrides = name_overrides.unwrap_or_default();
    service.export_sqlite_subset(&output_path, dataset_ids.as_deref(), &overrides)
}
