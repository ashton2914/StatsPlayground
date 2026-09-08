use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::AppError;
use crate::models::project::ProjectInfo;
use crate::models::save::{SaveProgress, SaveProjectRequest};
use crate::services::project_service::{OpenProjectResult, ProjectService};
use crate::services::workflow_domain::{self, WorkflowDefinition, WorkflowExtractionRequest};
use crate::state::AppState;

pub(crate) fn acquire_mutation_permit(
    state: &AppState,
) -> Result<crate::services::save_coordinator::MutationPermit<'_>, AppError> {
    state.save_coordinator.mutation_permit()
}

pub(crate) fn create_project_entry(
    state: &AppState,
    name: &str,
    file_path: &str,
) -> Result<ProjectInfo, AppError> {
    let _permit = acquire_mutation_permit(state)?;
    let service = ProjectService::new(state);
    service.create_project(name, file_path)
}

pub(crate) fn get_current_project_entry(state: &AppState) -> Result<Option<ProjectInfo>, AppError> {
    let service = ProjectService::new(state);
    service.get_current_project()
}

pub(crate) fn import_graph_entry(
    state: &AppState,
    file_path: &str,
) -> Result<serde_json::Value, AppError> {
    let service = ProjectService::new(state);
    service.import_graph(file_path)
}

#[tauri::command]
pub fn init_project(state: State<'_, AppState>) -> Result<ProjectInfo, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = ProjectService::new(&state);
    service.init_project()
}

#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    name: String,
    file_path: String,
) -> Result<ProjectInfo, AppError> {
    create_project_entry(state.inner(), &name, &file_path)
}

#[tauri::command(async)]
pub fn open_project(
    state: State<'_, AppState>,
    app: AppHandle,
    file_path: String,
) -> Result<OpenProjectResult, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = ProjectService::new(&state);
    service.open_project(
        &file_path,
        Some(&|ds_idx, ds_total, ds_name, rows_done, rows_total| {
            let _ = app.emit(
                "open-project-progress",
                serde_json::json!({
                    "datasetIndex": ds_idx,
                    "datasetTotal": ds_total,
                    "datasetName": ds_name,
                    "rowsDone": rows_done,
                    "rowsTotal": rows_total,
                }),
            );
        }),
    )
}

async fn run_save_on_blocking_pool<T, F>(work: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| AppError::FileIO(format!("save worker join failure: {error}")))?
}

#[tauri::command(async)]
pub async fn save_project(
    app: AppHandle,
    request: SaveProjectRequest,
    on_progress: Channel<SaveProgress>,
) -> Result<ProjectInfo, AppError> {
    run_save_on_blocking_pool(move || {
        let state = Manager::state::<AppState>(&app);
        let service = ProjectService::new(&state);
        service.save_project(
            request,
            Some(&|progress| {
                let _ = on_progress.send(progress);
            }),
        )
    })
    .await
}

#[tauri::command]
pub fn get_current_project(state: State<'_, AppState>) -> Result<Option<ProjectInfo>, AppError> {
    get_current_project_entry(state.inner())
}

#[tauri::command]
pub fn extract_workflow(
    request: WorkflowExtractionRequest,
) -> Result<WorkflowDefinition, AppError> {
    workflow_domain::extract_workflow(request)
}

// ----------------------------------------------------------------------------
// Single-table / single-graph share commands.
// .sptb = standalone table file (one dataset), .spgh = standalone graph file.
// ----------------------------------------------------------------------------

#[tauri::command]
pub fn export_table(
    state: State<'_, AppState>,
    dataset_id: String,
    file_path: String,
) -> Result<(), AppError> {
    let service = ProjectService::new(&state);
    service.export_table(&dataset_id, &file_path)
}

/// Export multiple datasets to a single `.zip` of `.sptb` files. The optional
/// `archive_paths` map provides `dataset_id → path inside the zip` (without
/// `.sptb`) so the UI can mirror its folder tree. Missing entries fall back
/// to the dataset's plain name at the zip root.
#[tauri::command(async)]
pub fn export_tables_sptb_zip(
    state: State<'_, AppState>,
    dataset_ids: Vec<String>,
    archive_paths: Option<std::collections::HashMap<String, String>>,
    output_path: String,
) -> Result<(), AppError> {
    let service = ProjectService::new(&state);
    let paths = archive_paths.unwrap_or_default();
    service.export_tables_sptb_zip(&dataset_ids, &paths, &output_path)
}

/// Result of importing a standalone `.sptb` into the current project.
/// Per issue #7 the `.sptb` body no longer carries folder info — the imported
/// table lands wherever the caller decides (root by default).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTableResult {
    pub id: String,
}

/// Returns the new dataset id assigned to the imported table.
#[tauri::command(async)]
pub fn import_table(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<ImportTableResult, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = ProjectService::new(&state);
    let id = service.import_table(&file_path)?;
    Ok(ImportTableResult { id })
}

#[tauri::command]
pub fn export_graph(
    state: State<'_, AppState>,
    graph: serde_json::Value,
    file_path: String,
) -> Result<(), AppError> {
    let service = ProjectService::new(&state);
    service.export_graph(graph, &file_path)
}

/// Returns the imported graph builder body (opaque JSON, frontend shape).
#[tauri::command]
pub fn import_graph(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<serde_json::Value, AppError> {
    import_graph_entry(state.inner(), &file_path)
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use crate::error::AppError;

    fn function_signature(source: &str, function_name: &str) -> String {
        let start = source
            .find(function_name)
            .unwrap_or_else(|| panic!("{function_name} command must exist"));
        let rest = &source[start..];
        let end = rest
            .find(") ->")
            .unwrap_or_else(|| panic!("{function_name} signature must contain a return type"));
        rest[..end + 1].to_string()
    }

    #[test]
    fn project_open_uses_async_command_scheduling() {
        let source = include_str!("project_commands.rs");
        let open_start = source
            .find("pub fn open_project(")
            .expect("open_project command must exist");
        let command_attribute = &source[..open_start];

        assert!(
            command_attribute
                .trim_end()
                .ends_with("#[tauri::command(async)]"),
            "open_project must not run archive and database work on Tauri's main command thread"
        );
    }

    #[test]
    fn sptb_import_uses_async_command_scheduling() {
        let source = include_str!("project_commands.rs");
        let import_start = source
            .find("pub fn import_table(")
            .expect("import_table command must exist");
        let command_attribute = &source[..import_start];

        assert!(
            command_attribute.trim_end().ends_with("#[tauri::command(async)]"),
            "import_table must not run blocking archive and database work on Tauri's main command thread"
        );
    }

    #[test]
    fn project_save_uses_async_command_scheduling() {
        let source = include_str!("project_commands.rs");
        let save_start = source
            .find("pub async fn save_project(")
            .expect("save_project command must exist");
        let command_attribute = &source[..save_start];

        assert!(
            command_attribute
                .trim_end()
                .ends_with("#[tauri::command(async)]"),
            "save_project must run off the Tauri main command thread"
        );
    }

    #[test]
    fn project_save_accepts_only_request_and_progress_channel() {
        let source = include_str!("project_commands.rs");
        let signature = function_signature(source, "pub async fn save_project(");

        assert!(
            signature.contains("request: SaveProjectRequest"),
            "save_project must accept one typed SaveProjectRequest object"
        );
        assert!(
            signature.contains("on_progress: Channel<SaveProgress>"),
            "save_project must accept a progress channel"
        );
        assert!(
            signature.contains("app: AppHandle"),
            "save_project must accept framework-injected AppHandle"
        );
        assert!(
            !signature.contains("state: State<'_, AppState>"),
            "save_project must not borrow State<'_> across blocking worker boundaries"
        );
        assert!(
            !signature.contains("file_path:"),
            "legacy loose save arguments must be removed from save_project"
        );
        assert!(
            !signature.contains("history:"),
            "legacy loose save arguments must be removed from save_project"
        );
        assert!(
            !signature.contains("snapshots:"),
            "legacy loose save arguments must be removed from save_project"
        );
        assert!(
            !signature.contains("graph_builders:"),
            "legacy loose save arguments must be removed from save_project"
        );
        assert!(
            !signature.contains("tabulates:"),
            "legacy loose save arguments must be removed from save_project"
        );
        assert!(
            !signature.contains("table_folders:"),
            "legacy loose save arguments must be removed from save_project"
        );
    }

    #[test]
    fn project_save_ignores_progress_channel_send_failures() {
        let source = include_str!("project_commands.rs");
        let body = source
            .split("pub async fn save_project(")
            .nth(1)
            .expect("save_project command must exist");

        assert!(
            body.contains("let _ = on_progress.send(progress);"),
            "save_project progress callback must ignore channel send failures"
        );
    }

    #[test]
    fn save_blocking_helper_yields_while_blocking_work_waits() {
        let (started_tx, started_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (probe_tx, probe_rx) = mpsc::channel::<()>();

        tauri::async_runtime::block_on(async move {
            let blocking: tauri::async_runtime::JoinHandle<Result<(), AppError>> =
                tauri::async_runtime::spawn(async move {
                    super::run_save_on_blocking_pool(move || {
                        let _ = started_tx.send(());
                        let _ = release_rx.recv();
                        Ok::<(), AppError>(())
                    })
                    .await
                });

            started_rx
                .recv_timeout(Duration::from_millis(500))
                .expect("blocking save closure should start on worker pool");

            tauri::async_runtime::spawn(async move {
                let _ = probe_tx.send(());
            });

            probe_rx
                .recv_timeout(Duration::from_millis(200))
                .expect("async caller should continue scheduling while blocking save is paused");

            let _ = release_tx.send(());
            blocking
                .await
                .expect("spawned save task should join")
                .expect("blocking save closure should complete");
        });
    }
}
