use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::AppError;
use crate::models::data_link::{
    ConnectionCredentials, ConnectionDefinition, DataLinkError, DataLinkErrorCategory,
    ImportSummary, ImportTableSummary, PreviewResult, SourceColumn, SourceObject, SourceObjectRef,
    SqliteImportSelection,
};
use crate::services::data_link_service::DataLinkService;
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

fn active_imports() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static ACTIVE_IMPORTS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    ACTIVE_IMPORTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn validate_selections(selections: &[SqliteImportSelection]) -> Result<(), AppError> {
    if selections.is_empty() {
        return Err(AppError::InvalidParam(
            "Select at least one SQLite table".to_string(),
        ));
    }

    let mut source_names = HashSet::new();
    let mut target_names = HashSet::new();
    for selection in selections {
        if selection.action != "create"
            && selection.action != "append"
            && selection.action != "skip"
        {
            return Err(AppError::InvalidParam(format!(
                "Unsupported SQLite import action: {}",
                selection.action
            )));
        }
        if !source_names.insert(selection.source_name.to_lowercase()) {
            return Err(AppError::InvalidParam(format!(
                "SQLite table selected more than once: {}",
                selection.source_name
            )));
        }
        if selection.action == "create"
            && !target_names.insert(selection.target_name.to_lowercase())
        {
            return Err(AppError::InvalidParam(format!(
                "Duplicate target dataset name: {}",
                selection.target_name
            )));
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub async fn test_server_connection(definition: ConnectionDefinition, credentials: ConnectionCredentials) -> Result<(), DataLinkError> {
    tokio::task::spawn_blocking(move || DataLinkService::test_server_connection(definition, credentials))
        .await.map_err(|_| server_worker_error())?
}

#[tauri::command(async)]
pub async fn list_server_source_objects(definition: ConnectionDefinition, credentials: ConnectionCredentials) -> Result<Vec<SourceObjectRef>, DataLinkError> {
    tokio::task::spawn_blocking(move || DataLinkService::list_server_objects(definition, credentials))
        .await.map_err(|_| server_worker_error())?
}

#[tauri::command(async)]
pub async fn get_server_source_schema(definition: ConnectionDefinition, credentials: ConnectionCredentials, object: SourceObjectRef) -> Result<Vec<SourceColumn>, DataLinkError> {
    tokio::task::spawn_blocking(move || DataLinkService::get_server_schema(definition, credentials, object))
        .await.map_err(|_| server_worker_error())?
}

#[tauri::command(async)]
pub async fn preview_server_source_object(definition: ConnectionDefinition, credentials: ConnectionCredentials, object: SourceObjectRef, limit: usize) -> Result<PreviewResult, DataLinkError> {
    tokio::task::spawn_blocking(move || DataLinkService::preview_server_object(definition, credentials, object, limit))
        .await.map_err(|_| server_worker_error())?
}

#[tauri::command(async)]
pub async fn import_server_snapshot(app: AppHandle, definition: ConnectionDefinition, credentials: ConnectionCredentials, object: SourceObjectRef, target_name: String) -> Result<ImportSummary, AppError> {
    if target_name.trim().is_empty() {
        return Err(AppError::InvalidParam("Target dataset name is required".into()));
    }
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _permit = crate::commands::io_commands::acquire_mutation_permit(state.inner())?;
        IoService::new(state.inner()).import_server_snapshot(definition, credentials, object, target_name.trim(), |_, _| {}, || false)
    }).await.map_err(|_| AppError::Database("Database import worker failed".into()))?
}

fn server_worker_error() -> DataLinkError {
    DataLinkError::new(DataLinkErrorCategory::Query, "Database operation could not be completed")
}

#[tauri::command(async)]
pub async fn test_postgres_connection(
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
) -> Result<(), DataLinkError> {
    tokio::task::spawn_blocking(move || {
        DataLinkService::test_postgres_connection(definition, credentials)
    })
    .await
    .map_err(|_| postgres_worker_error())?
}

#[tauri::command(async)]
pub async fn list_postgres_source_objects(
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
) -> Result<Vec<SourceObjectRef>, DataLinkError> {
    tokio::task::spawn_blocking(move || {
        DataLinkService::list_postgres_objects(definition, credentials)
    })
    .await
    .map_err(|_| postgres_worker_error())?
}

#[tauri::command(async)]
pub async fn get_postgres_source_schema(
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
    object: SourceObjectRef,
) -> Result<Vec<SourceColumn>, DataLinkError> {
    tokio::task::spawn_blocking(move || {
        DataLinkService::get_postgres_schema(definition, credentials, object)
    })
    .await
    .map_err(|_| postgres_worker_error())?
}

#[tauri::command(async)]
pub async fn preview_postgres_source_object(
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
    object: SourceObjectRef,
    limit: usize,
) -> Result<PreviewResult, DataLinkError> {
    tokio::task::spawn_blocking(move || {
        DataLinkService::preview_postgres_object(definition, credentials, object, limit)
    })
    .await
    .map_err(|_| postgres_worker_error())?
}

#[tauri::command(async)]
pub async fn import_postgres_snapshot(
    app: AppHandle,
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
    object: SourceObjectRef,
    target_name: String,
) -> Result<ImportSummary, AppError> {
    if target_name.trim().is_empty() {
        return Err(AppError::InvalidParam(
            "PostgreSQL target dataset name is required".to_string(),
        ));
    }
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _permit = crate::commands::io_commands::acquire_mutation_permit(state.inner())?;
        IoService::new(state.inner()).import_postgres_snapshot(
            definition,
            credentials,
            object,
            target_name.trim(),
            |_, _| {},
            || false,
        )
    })
    .await
    .map_err(|_| AppError::Database("PostgreSQL import worker failed".to_string()))?
}

fn postgres_worker_error() -> DataLinkError {
    DataLinkError::new(
        DataLinkErrorCategory::Query,
        "PostgreSQL operation could not be completed",
    )
}

#[tauri::command(async)]
pub async fn list_sqlite_source_objects(file_path: String) -> Result<Vec<SourceObject>, AppError> {
    tokio::task::spawn_blocking(move || DataLinkService::list_sqlite_objects(&file_path))
        .await
        .map_err(|error| AppError::Database(format!("DataLink worker failed: {error}")))?
}

#[tauri::command(async)]
pub async fn preview_sqlite_source_object(
    file_path: String,
    object_name: String,
    limit: usize,
) -> Result<PreviewResult, AppError> {
    tokio::task::spawn_blocking(move || {
        DataLinkService::preview_sqlite_object(&file_path, &object_name, limit)
    })
    .await
    .map_err(|error| AppError::Database(format!("DataLink worker failed: {error}")))?
}

#[tauri::command(async)]
pub fn import_selected_sqlite(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    request_id: String,
    selections: Vec<SqliteImportSelection>,
) -> Result<ImportSummary, AppError> {
    validate_selections(&selections)?;

    if request_id.trim().is_empty() {
        return Err(AppError::InvalidParam(
            "Import request ID is required".to_string(),
        ));
    }
    let _permit = crate::commands::io_commands::acquire_mutation_permit(state.inner())?;
    let cancellation = Arc::new(AtomicBool::new(false));
    {
        let mut imports = active_imports()
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        if imports.contains_key(&request_id) {
            return Err(AppError::InvalidParam(format!(
                "Duplicate import request ID: {request_id}"
            )));
        }
        imports.insert(request_id.clone(), Arc::clone(&cancellation));
    }

    let failed_table = Arc::new(Mutex::new(None::<String>));
    let progress_table = Arc::clone(&failed_table);
    let skipped = selections
        .iter()
        .filter(|selection| selection.action == "skip")
        .map(|selection| ImportTableSummary {
            source_name: selection.source_name.clone(),
            target_name: selection.target_name.clone(),
            action: selection.action.clone(),
            rows_written: 0,
        })
        .collect::<Vec<_>>();
    let result = IoService::new(state.inner()).import_selected_sqlite(
        &file_path,
        &selections,
        |table_name, table_index, table_total, rows_done, rows_total| {
            if let Ok(mut current_table) = progress_table.lock() {
                *current_table = Some(table_name.to_string());
            }
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
        || cancellation.load(Ordering::Relaxed),
    );
    if let Ok(mut imports) = active_imports().lock() {
        imports.remove(&request_id);
    }
    match result {
        Ok(summary) => Ok(summary),
        Err(AppError::Cancelled(error)) => Ok(ImportSummary {
            status: "cancelled".to_string(),
            imported: Vec::new(),
            skipped: skipped.clone(),
            failed_table: failed_table.lock().ok().and_then(|table| table.clone()),
            error: Some(error),
            total_rows_written: 0,
        }),
        Err(error) => Ok(ImportSummary {
            status: "failed".to_string(),
            imported: Vec::new(),
            skipped,
            failed_table: failed_table.lock().ok().and_then(|table| table.clone()),
            error: Some(error.to_string()),
            total_rows_written: 0,
        }),
    }
}

#[tauri::command]
pub fn cancel_sqlite_import(request_id: String) -> Result<(), AppError> {
    let imports = active_imports()
        .lock()
        .map_err(|error| AppError::Database(error.to_string()))?;
    if let Some(cancellation) = imports.get(&request_id) {
        cancellation.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selection(source_name: &str, target_name: &str) -> SqliteImportSelection {
        SqliteImportSelection {
            source_name: source_name.to_string(),
            target_name: target_name.to_string(),
            action: "create".to_string(),
        }
    }

    #[test]
    fn rejects_duplicate_source_and_target_names_case_insensitively() {
        let duplicate_source = validate_selections(&[
            selection("People", "People 1"),
            selection("people", "People 2"),
        ])
        .expect_err("reject duplicate source");
        assert!(duplicate_source
            .to_string()
            .contains("selected more than once"));

        let duplicate_target = validate_selections(&[
            selection("People", "Imported"),
            selection("Orders", "imported"),
        ])
        .expect_err("reject duplicate target");
        assert!(duplicate_target
            .to_string()
            .contains("Duplicate target dataset name"));
    }
}
