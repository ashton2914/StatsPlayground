use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::AppError;
use crate::models::project::ProjectInfo;
use crate::models::project_persistence::{ProjectMutationResult,ProjectWriteContext};
use crate::models::save::{SaveProgress, SaveProjectRequest};
use crate::services::project_service::{ImportedTableTransform, OpenProjectResult, ProjectService};
use crate::services::spprj_archive;
use crate::services::table_transform_domain::{TableTransformDefinition, TableTransformDraft};
use crate::services::table_transform_service::{
    TableTransformInputBinding, TableTransformProjectBinding, TableTransformService,
};
use crate::services::workflow_domain::{
    self, ProjectLineageGraph, WorkflowDefinition, WorkflowExtractionRequest,
};
use crate::services::workflow_executor::{
    WorkflowExecutor, WorkflowRunCommitPacket, WorkflowRunRequest,
};
use crate::state::AppState;

pub use crate::services::table_transform_service::TableTransformCommandResult;

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

pub(crate) fn create_table_transform_entry(
    state: &AppState,
    draft: TableTransformDraft,
    input_bindings: Vec<TableTransformInputBinding>,
    mut lineage_graph: ProjectLineageGraph,
) -> Result<TableTransformCommandResult, AppError> {
    let _permit = acquire_mutation_permit(state)?;
    let engine = state
        .db
        .lock()
        .map_err(|error| AppError::Database(error.to_string()))?;
    let (definition, execution) = TableTransformService::new(&engine).create_from_draft(
        &draft,
        input_bindings,
        &mut lineage_graph,
    )?;
    Ok(TableTransformCommandResult {
        definition,
        execution,
        lineage_graph,
    })
}

pub(crate) fn preflight_create_table_transform_entry(
    state: &AppState,
    draft: TableTransformDraft,
    input_bindings: Vec<TableTransformInputBinding>,
) -> Result<(), AppError> {
    let engine = state
        .db
        .lock()
        .map_err(|error| AppError::Database(error.to_string()))?;
    TableTransformService::new(&engine).preflight_create_from_draft(&draft, input_bindings)
}

fn run_table_transform_entry(
    state: &AppState,
    definition: TableTransformDefinition,
    binding: TableTransformProjectBinding,
    mut lineage_graph: ProjectLineageGraph,
) -> Result<TableTransformCommandResult, AppError> {
    let _permit = acquire_mutation_permit(state)?;
    let engine = state
        .db
        .lock()
        .map_err(|error| AppError::Database(error.to_string()))?;
    let execution =
        TableTransformService::new(&engine).run(&definition, &binding, &mut lineage_graph)?;
    Ok(TableTransformCommandResult {
        definition,
        execution,
        lineage_graph,
    })
}

fn preflight_run_table_transform_entry(
    state: &AppState,
    definition: TableTransformDefinition,
    binding: TableTransformProjectBinding,
) -> Result<(), AppError> {
    let engine = state
        .db
        .lock()
        .map_err(|error| AppError::Database(error.to_string()))?;
    TableTransformService::new(&engine).preflight_run(&definition, &binding)
}

fn rebind_table_transform_entry(
    state: &AppState,
    definition: TableTransformDefinition,
    binding: TableTransformProjectBinding,
    input_bindings: Vec<TableTransformInputBinding>,
    mut lineage_graph: ProjectLineageGraph,
) -> Result<TableTransformCommandResult, AppError> {
    let _permit = acquire_mutation_permit(state)?;
    let rebound = TableTransformProjectBinding {
        inputs: input_bindings,
        ..binding
    };
    let engine = state
        .db
        .lock()
        .map_err(|error| AppError::Database(error.to_string()))?;
    let execution =
        TableTransformService::new(&engine).run(&definition, &rebound, &mut lineage_graph)?;
    Ok(TableTransformCommandResult {
        definition,
        execution,
        lineage_graph,
    })
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

#[tauri::command(async)]
pub async fn run_workflow(
    app: AppHandle,
    request: WorkflowRunRequest,
    context:Option<ProjectWriteContext>,
    folder:Option<String>,
) -> Result<ProjectMutationResult<WorkflowRunCommitPacket>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = Manager::state::<AppState>(&app);
        if let Some(context)=context {
            let commit=crate::services::project_native_service::NativeProjectService::new(&state).run_workflow(&context,&request,folder.as_deref().unwrap_or(""))?;
            if app.emit("project-committed",&commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
            return Ok(ProjectMutationResult::Committed(commit));
        }
        state.save_coordinator.ensure_legacy_project()?;
        WorkflowExecutor::new(&state).execute(request).map(ProjectMutationResult::Legacy)
    })
    .await
    .map_err(|error| AppError::Stats(format!("workflow worker join failure: {error}")))?
}

#[tauri::command]
pub fn acknowledge_workflow_commit(
    state: State<'_, AppState>,
    commit_id: String,
) -> Result<(), AppError> {
    WorkflowExecutor::new(&state).acknowledge(&commit_id)
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
    epoch:Option<u64>,
) -> Result<(), AppError> {
    let _export=crate::services::project_export::acquire_export_project(state.inner(),epoch)?;
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
    epoch:Option<u64>,
) -> Result<(), AppError> {
    let _export=crate::services::project_export::acquire_export_project(state.inner(),epoch)?;
    let service = ProjectService::new(&state);
    let paths = archive_paths.unwrap_or_default();
    service.export_tables_sptb_zip(&dataset_ids, &paths, &output_path)
}

/// Result of importing a standalone `.sptb` into the current project.
/// Per issue #7 the `.sptb` body no longer carries folder info — the imported
/// table lands wherever the caller decides (root by default).
pub type ImportTableResult = crate::models::project_persistence::ProjectTableImportResult;

/// Returns the new dataset id assigned to the imported table.
#[tauri::command(async)]
pub fn import_table(
    app:AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<ImportTableResult>, AppError> {
    if let Some(context) = context {
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).import_sptb(&context,&file_path,||false)?;
        if app.emit("project-committed",&commit).is_err(){eprintln!("project_commit_event_delivery_failed");}
        return Ok(ProjectMutationResult::Committed(commit));
    }
    let _permit = acquire_mutation_permit(state.inner())?;
    let service = ProjectService::new(&state);
    let id = service.import_table(&file_path)?;
    Ok(ProjectMutationResult::Legacy(ImportTableResult { id }))
}

/// Returns the imported graph builder body (opaque JSON, frontend shape).
#[tauri::command]
pub fn import_graph(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<serde_json::Value, AppError> {
    import_graph_entry(state.inner(), &file_path)
}

#[tauri::command(async)]
pub fn create_table_transform(
    app: AppHandle,
    state: State<'_, AppState>,
    draft: TableTransformDraft,
    input_bindings: Vec<TableTransformInputBinding>,
    lineage_graph: ProjectLineageGraph,
    context: Option<crate::models::project_persistence::ProjectWriteContext>,
) -> Result<
    crate::models::project_persistence::ProjectMutationResult<TableTransformCommandResult>,
    AppError,
> {
    if let Some(context) = context {
        let commit = crate::services::project_native_service::NativeProjectService::new(&state)
            .create_transform(&context, &draft, &input_bindings)?;
        if app.emit("project-committed", &commit).is_err() {
            eprintln!("project_commit_event_delivery_failed");
        }
        return Ok(crate::models::project_persistence::ProjectMutationResult::Committed(commit));
    }
    create_table_transform_entry(state.inner(), draft, input_bindings, lineage_graph)
        .map(crate::models::project_persistence::ProjectMutationResult::Legacy)
}

#[tauri::command]
pub fn preflight_create_table_transform(
    state: State<'_, AppState>,
    draft: TableTransformDraft,
    input_bindings: Vec<TableTransformInputBinding>,
    _lineage_graph: ProjectLineageGraph,
) -> Result<(), AppError> {
    preflight_create_table_transform_entry(state.inner(), draft, input_bindings)
}

#[tauri::command(async)]
pub fn run_table_transform(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    definition: TableTransformDefinition,
    binding: TableTransformProjectBinding,
    lineage_graph: ProjectLineageGraph,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<TableTransformCommandResult>, AppError> {
    if let Some(context)=context {
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).run_transform(&context,&definition,&binding,None)?;
        if app.emit("project-committed",&commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
        return Ok(ProjectMutationResult::Committed(commit));
    }
    run_table_transform_entry(state.inner(), definition, binding, lineage_graph).map(ProjectMutationResult::Legacy)
}

#[tauri::command]
pub fn preflight_run_table_transform(
    state: State<'_, AppState>,
    definition: TableTransformDefinition,
    binding: TableTransformProjectBinding,
    _lineage_graph: ProjectLineageGraph,
) -> Result<(), AppError> {
    preflight_run_table_transform_entry(state.inner(), definition, binding)
}

#[tauri::command(async)]
pub fn rebind_table_transform(
    app:tauri::AppHandle,
    state: State<'_, AppState>,
    definition: TableTransformDefinition,
    binding: TableTransformProjectBinding,
    input_bindings: Vec<TableTransformInputBinding>,
    lineage_graph: ProjectLineageGraph,
    context:Option<ProjectWriteContext>,
) -> Result<ProjectMutationResult<TableTransformCommandResult>, AppError> {
    if let Some(context)=context {
        let commit=crate::services::project_native_service::NativeProjectService::new(&state).run_transform(&context,&definition,&binding,Some(&input_bindings))?;
        if app.emit("project-committed",&commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
        return Ok(ProjectMutationResult::Committed(commit));
    }
    rebind_table_transform_entry(state.inner(),definition,binding,input_bindings,lineage_graph).map(ProjectMutationResult::Legacy)
}

#[tauri::command]
pub fn export_table_transform(
    definition: TableTransformDefinition,
    file_path: String,
) -> Result<(), AppError> {
    spprj_archive::write_table_transform_file(&definition, &file_path)
}

#[tauri::command]
pub fn import_table_transform(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<ImportedTableTransform, AppError> {
    let _permit = acquire_mutation_permit(state.inner())?;
    ProjectService::new(&state).import_table_transform(&file_path)
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use crate::error::AppError;
    use crate::services::table_transform_domain::{
        SortColumn, SortDirection, TableTransformDraft, TableTransformOperation,
    };
    use crate::services::table_transform_service::{
        TableTransformInputBinding, TableTransformRunStatus,
    };
    use crate::services::workflow_domain::ProjectLineageGraph;
    use crate::state::AppState;

    #[test]
    fn native_import_table_command_preserves_receipt_and_legacy_value_contract() {
        let _:for<'a> fn(tauri::AppHandle,tauri::State<'a,AppState>,String,Option<crate::models::project_persistence::ProjectWriteContext>)->Result<crate::models::project_persistence::ProjectMutationResult<super::ImportTableResult>,AppError>=super::import_table;
        let legacy=crate::models::project_persistence::ProjectMutationResult::Legacy(super::ImportTableResult{id:"imported".into()});
        assert_eq!(serde_json::to_value(legacy).unwrap(),serde_json::json!({"id":"imported"}));
    }

    #[test]
    fn native_table_lifecycle_commands_keep_epoch_and_commit_contracts() {
        use crate::models::project_persistence::{ProjectCommit,ProjectWriteContext,ProjectTableLifecycleEvent};
        let _:for<'a> fn(tauri::State<'a,AppState>,u64,bool)->Result<crate::models::project_persistence::ProjectHistoryFrontier,AppError>=super::get_project_history_frontier;
        let _:for<'a> fn(tauri::State<'a,AppState>,u64,String)->Result<ProjectTableLifecycleEvent,AppError>=super::get_project_table_lifecycle_event;
        let _:for<'a> fn(tauri::AppHandle,tauri::State<'a,AppState>,ProjectWriteContext,String,u64,bool)->Result<ProjectCommit<()>,AppError>=super::apply_project_table_lifecycle;
    }

    #[test]
    fn native_project_migration_commands_keep_preflight_cancel_and_outcome_contracts() {
        use crate::models::project_persistence::{ProjectMigrationPreflight,ProjectSnapshotOutcome};
        let _:fn(String,Option<String>)->Result<ProjectMigrationPreflight,AppError>=super::preflight_project_migration;
        let _:for<'a> fn(tauri::State<'a,AppState>,String)->Result<bool,AppError>=super::cancel_project_migration;
        let _:for<'a> fn(tauri::State<'a,AppState>,tauri::AppHandle,String,String,String)->Result<ProjectSnapshotOutcome,AppError>=super::migrate_project_v5;
    }

    #[test]
    #[cfg(feature="project-v5")]
    fn native_project_migration_entry_reports_owned_cancellation_and_durable_completion() {
        use crate::services::{project_database::ProjectDatabase,project_native_service::NativeProjectService};
        use sha2::{Digest,Sha256};
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("old.spprj");let target=dir.path().join("new.spprj");let live=dir.path().join("live.spprj");
        std::fs::write(&source,br#"{"name":"Old","version":"1.0.0","datasets":[{"id":"table","name":"Data","sourceType":"csv","columns":[{"name":"Value","colType":"DOUBLE"}],"rows":[[1,22]]}]}"#).unwrap();
        let hash=Sha256::digest(std::fs::read(&source).unwrap());
        let db=ProjectDatabase::create(&live,false).unwrap();db.prepare_close(db.epoch()).unwrap();
        let state=AppState::new().unwrap();let native=NativeProjectService::new(&state);let previous=native.open(&live,false).unwrap();
        let id=uuid::Uuid::new_v4().to_string();
        let cancelled=super::migrate_project_v5_entry(&state,source.to_str().unwrap(),target.to_str().unwrap(),&id,&|index,total,_,_,_|{if index<total {assert!(state.project_migrations.cancel(&id).unwrap());}}).unwrap();
        assert!(cancelled.active.is_none());assert!(!cancelled.destination_published);assert!(cancelled.error.unwrap().starts_with("Cancelled:"));assert!(!target.exists());
        assert_eq!(state.project_database.read().unwrap().as_ref().unwrap().epoch(),previous.epoch);assert!(!state.project_migrations.cancel(&id).unwrap());
        let started=std::sync::atomic::AtomicBool::new(false);
        let success=super::migrate_project_v5_entry(&state,source.to_str().unwrap(),target.to_str().unwrap(),&uuid::Uuid::new_v4().to_string(),&|index,total,_,_,_|{if total==0 {started.store(true,std::sync::atomic::Ordering::Relaxed);} if total>0&&index==total {assert!(target.exists());assert_ne!(state.project_database.read().unwrap().as_ref().unwrap().epoch(),previous.epoch);}}).unwrap();
        assert!(started.load(std::sync::atomic::Ordering::Relaxed),"registration must be announced before conversion starts");
        assert!(success.destination_published);assert!(success.error.is_none());let opened=success.active.unwrap();assert_eq!(opened.datasets[0].source_type,"csv");native.close(opened.epoch).unwrap();
        assert_eq!(Sha256::digest(std::fs::read(&source).unwrap()),hash);
    }

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

    #[test]
    fn create_table_transform_command_executes_against_real_project_state() {
        let state = AppState::new().expect("create state");
        let operation = TableTransformOperation::Sort {
            sort_columns: vec![SortColumn {
                column: "value".to_string(),
                direction: SortDirection::Ascending,
            }],
        };
        {
            let engine = state.db.lock().expect("lock database");
            engine
                .create_empty_table(
                    "source-table",
                    "Source",
                    &["value".to_string()],
                    &["BIGINT".to_string()],
                )
                .expect("create source");
            let row = engine.add_row("source-table").expect("add row");
            engine
                .update_cell("source-table", row, "value", "2")
                .expect("set value");
        }
        let draft = TableTransformDraft {
            name: "Reusable sort".to_string(),
            output_name: "Sorted output".to_string(),
            operation,
        };

        let result = super::create_table_transform_entry(
            &state,
            draft,
            vec![TableTransformInputBinding {
                role: "source".to_string(),
                table_document_id: "source-table".to_string(),
            }],
            ProjectLineageGraph::default(),
        )
        .expect("execute transform");

        assert_eq!(result.execution.status, TableTransformRunStatus::Succeeded);
        let output_id = result.execution.output.expect("stable output").id;
        assert_eq!(result.definition.output.table_document_id, output_id);
        assert_eq!(result.definition.input_slots[0].role, "source");
        assert!(!result.lineage_graph.nodes.is_empty());
    }

    #[test]
    fn table_transform_commands_are_registered() {
        let source = include_str!("../lib.rs");
        for command in [
            "preflight_create_table_transform",
            "create_table_transform",
            "preflight_run_table_transform",
            "run_table_transform",
            "rebind_table_transform",
            "export_table_transform",
            "import_table_transform",
        ] {
            assert!(
                source.contains(&format!("commands::project_commands::{command}")),
                "{command} must be registered"
            );
        }
    }

    #[test]
    fn preflight_create_table_transform_has_no_side_effects() {
        let state = AppState::new().expect("create state");
        {
            let engine = state.db.lock().expect("lock database");
            engine
                .create_empty_table(
                    "source-table",
                    "Source",
                    &["value".to_string()],
                    &["BIGINT".to_string()],
                )
                .expect("create source");
        }

        let before = {
            let engine = state.db.lock().expect("lock database");
            engine.list_datasets().expect("list before")
        };

        let draft = TableTransformDraft {
            name: "Reusable sort".to_string(),
            output_name: "Sorted output".to_string(),
            operation: TableTransformOperation::Sort {
                sort_columns: vec![SortColumn {
                    column: "value".to_string(),
                    direction: SortDirection::Ascending,
                }],
            },
        };

        super::preflight_create_table_transform_entry(
            &state,
            draft,
            vec![TableTransformInputBinding {
                role: "source".to_string(),
                table_document_id: "source-table".to_string(),
            }],
        )
        .expect("preflight should succeed");

        let after = {
            let engine = state.db.lock().expect("lock database");
            engine.list_datasets().expect("list after")
        };

        assert_eq!(before.len(), after.len());
        assert_eq!(before[0].id, after[0].id);
        assert_eq!(before[0].name, after[0].name);
    }

    #[test]
    fn preflight_run_table_transform_matches_run_validation_errors() {
        let state = AppState::new().expect("create state");
        {
            let engine = state.db.lock().expect("lock database");
            engine
                .create_empty_table(
                    "source-table",
                    "Source",
                    &["value".to_string()],
                    &["BIGINT".to_string()],
                )
                .expect("create source");
        }

        let draft = TableTransformDraft {
            name: "Reusable sort".to_string(),
            output_name: "Sorted output".to_string(),
            operation: TableTransformOperation::Sort {
                sort_columns: vec![SortColumn {
                    column: "value".to_string(),
                    direction: SortDirection::Ascending,
                }],
            },
        };

        let created = super::create_table_transform_entry(
            &state,
            draft,
            vec![TableTransformInputBinding {
                role: "source".to_string(),
                table_document_id: "source-table".to_string(),
            }],
            ProjectLineageGraph::default(),
        )
        .expect("create transform");

        let mut stale_binding = created.execution.binding.clone();
        stale_binding.definition_revision += 1;

        let datasets_before = {
            let engine = state.db.lock().expect("lock database");
            engine.list_datasets().expect("list before")
        };

        let error =
            super::preflight_run_table_transform_entry(&state, created.definition, stale_binding)
                .expect_err("stale definition should fail in preflight");

        assert!(
            matches!(error, AppError::InvalidParam(message) if message.contains("stale table transform definition revision"))
        );

        let datasets_after = {
            let engine = state.db.lock().expect("lock database");
            engine.list_datasets().expect("list after")
        };
        assert_eq!(datasets_before.len(), datasets_after.len());
        assert_eq!(datasets_before[0].id, datasets_after[0].id);
        assert_eq!(datasets_before[0].name, datasets_after[0].name);
    }
}

#[tauri::command(async)]
pub fn open_project_v5(
    state: State<'_, AppState>,
    file_path: String,
    read_only: bool,
) -> Result<crate::models::project_persistence::ProjectOpenSummary, AppError> {
    ProjectService::new(&state).open_project_v5(&file_path, read_only)
}

#[tauri::command(async)]
pub fn preflight_project_migration(source_path:String,destination_path:Option<String>)->Result<crate::models::project_persistence::ProjectMigrationPreflight,AppError> {
    crate::services::project_migration::ProjectMigrationService::preflight(std::path::Path::new(&source_path),destination_path.as_deref().map(std::path::Path::new))
}

#[tauri::command]
pub fn cancel_project_migration(state:State<'_,AppState>,migration_id:String)->Result<bool,AppError> {
    crate::services::project_schema::require_v5_capability()?;
    state.project_migrations.cancel(&migration_id)
}

pub(crate) fn migrate_project_v5_entry(state:&AppState,source_path:&str,destination_path:&str,migration_id:&str,progress:&crate::services::project_migration::MigrationProgressCallback<'_>)->Result<crate::models::project_persistence::ProjectSnapshotOutcome,AppError> {
    crate::services::project_schema::require_v5_capability()?;
    let request=state.project_migrations.register(migration_id)?;
    progress(0,0,"",0,0);
    let result=crate::services::project_migration::ProjectMigrationService::new(state).migrate_with_cancel(std::path::Path::new(source_path),std::path::Path::new(destination_path),progress,&||request.cancelled());
    Ok(crate::services::project_migration::finish_migration_result(result))
}

#[tauri::command(async)]
pub fn migrate_project_v5(state:State<'_,AppState>,app:AppHandle,source_path:String,destination_path:String,migration_id:String)->Result<crate::models::project_persistence::ProjectSnapshotOutcome,AppError> {
    migrate_project_v5_entry(&state,&source_path,&destination_path,&migration_id,&|dataset_index,dataset_total,dataset_name,rows_done,rows_total| {
        let _=app.emit("project-migration-progress",serde_json::json!({"migrationId":migration_id,"datasetIndex":dataset_index,"datasetTotal":dataset_total,"datasetName":dataset_name,"rowsDone":rows_done,"rowsTotal":rows_total}));
    })
}

#[tauri::command(async)]
pub fn list_project_catalog(
    state: State<'_, AppState>,
    epoch: u64,
    request: crate::models::project_persistence::CatalogPageRequest,
) -> Result<crate::models::project_persistence::CatalogPage, AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state)
        .list_catalog(epoch, &request)
}

#[tauri::command(async)]
pub fn get_project_document(
    state: State<'_, AppState>,
    epoch: u64,
    id: String,
    expected_revision: u64,
) -> Result<crate::models::project_persistence::ProjectDocumentBody, AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state).get_document(
        epoch,
        &id,
        expected_revision,
    )
}

#[tauri::command(async)]
pub fn get_project_workflow_run_state(state:State<'_,AppState>,epoch:u64,workflow_id:String,workflow_revision:u64)->Result<crate::models::project_persistence::ProjectWorkflowRunState,AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state).workflow_run_state(epoch,&workflow_id,workflow_revision)
}

#[tauri::command(async)]
pub fn get_project_history_frontier(state:State<'_,AppState>,epoch:u64,undo:bool)->Result<crate::models::project_persistence::ProjectHistoryFrontier,AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state).history_frontier(epoch,None,undo)
}

#[tauri::command(async)]
pub fn get_project_table_lifecycle_event(state:State<'_,AppState>,epoch:u64,event_id:String)->Result<crate::models::project_persistence::ProjectTableLifecycleEvent,AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state).table_lifecycle_event(epoch,&event_id)
}

#[tauri::command(async)]
pub fn apply_project_table_lifecycle(app:AppHandle,state:State<'_,AppState>,context:ProjectWriteContext,event_id:String,event_revision:u64,undo:bool)->Result<crate::models::project_persistence::ProjectCommit<()>,AppError> {
    let commit=crate::services::project_native_service::NativeProjectService::new(&state).apply_table_lifecycle(&context,&event_id,event_revision,undo)?;
    if app.emit("project-committed",&commit).is_err(){eprintln!("project_commit_event_delivery_failed");}
    Ok(commit)
}

#[tauri::command(async)]
pub fn list_project_history(
    state: State<'_, AppState>,
    epoch: u64,
    request: crate::models::project_persistence::HistoryPageRequest,
) -> Result<crate::models::project_persistence::ProjectHistoryPage, AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state)
        .list_history(epoch, &request)
}

#[tauri::command(async)]
pub fn resolve_project_operation(app:AppHandle,state:State<'_,AppState>,context:ProjectWriteContext)->Result<crate::models::project_persistence::ProjectOperationResolution,AppError> {
    let resolution=crate::services::project_native_service::NativeProjectService::new(&state).resolve_operation(&context)?;
    if let crate::models::project_persistence::ProjectOperationResolution::Committed{commit}=&resolution {
        if app.emit("project-committed",commit).is_err() {eprintln!("project_commit_event_delivery_failed");}
    }
    Ok(resolution)
}

#[tauri::command(async)]
pub fn commit_project_records(
    app: AppHandle,
    state: State<'_, AppState>,
    context: crate::models::project_persistence::ProjectWriteContext,
    patch: crate::models::project_persistence::ProjectRecordPatch,
) -> Result<crate::models::project_persistence::ProjectCommit<()>, AppError> {
    let commit = crate::services::project_native_service::NativeProjectService::new(&state)
        .commit_records(&context, &patch)?;
    if app.emit("project-committed", &commit).is_err() {
        eprintln!("project_commit_event_delivery_failed");
    }
    Ok(commit)
}

#[tauri::command(async)]
pub fn get_project_persistence_status(
    state: State<'_, AppState>,
    epoch: u64,
) -> Result<crate::models::project_persistence::ProjectPersistenceStatus, AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state).status(epoch)
}

#[tauri::command(async)]
pub fn get_project_setting(
    state: State<'_, AppState>,
    epoch: u64,
    key: String,
) -> Result<Option<crate::models::project_persistence::ProjectSettingRecord>, AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state)
        .get_setting(epoch, &key)
}

fn project_draft_root(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    Ok(app.path().app_data_dir().map_err(|e| AppError::FileIO(e.to_string()))?.join("project-drafts-v5"))
}

#[tauri::command(async)]
pub fn create_project_draft_v5(app: AppHandle, state: State<'_, AppState>) -> Result<crate::models::project_persistence::ProjectOpenSummary, AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state).create_draft(&project_draft_root(&app)?)
}
#[tauri::command(async)]
pub fn list_recoverable_project_drafts(app: AppHandle) -> Result<Vec<crate::services::project_drafts::DraftDescriptor>, AppError> {
    crate::services::project_schema::require_v5_capability()?;
    crate::services::project_drafts::ProjectDraftRegistry::list_recoverable(&project_draft_root(&app)?)
}
#[tauri::command(async)]
pub fn recover_project_draft_v5(app: AppHandle, state: State<'_, AppState>, recovery_id: String) -> Result<crate::models::project_persistence::ProjectOpenSummary, AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state).recover_draft(&project_draft_root(&app)?, &recovery_id)
}
#[tauri::command(async)]
pub fn close_project_v5(state: State<'_, AppState>, epoch: u64) -> Result<(), AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state).close(epoch)
}
#[tauri::command(async)]
pub fn snapshot_project_v5(app: AppHandle, state: State<'_, AppState>, epoch: u64, file_path: String, first_naming: bool) -> Result<crate::models::project_persistence::ProjectSnapshotOutcome, AppError> {
    let mut result = crate::services::project_native_service::NativeProjectService::new(&state)
        .snapshot(epoch, std::path::Path::new(&file_path), first_naming)?;
    if first_naming && result.error.is_none() {
        if let Some(active) = &result.active {
            let marking = project_draft_root(&app).and_then(|root|
                crate::services::project_drafts::ProjectDraftRegistry::mark_named(&root, &active.header.project_id));
            if let Err(error) = marking {
                result.error = Some(error.to_string());
            }
        }
    }
    Ok(result)
}
#[tauri::command]
pub fn project_v5_enabled() -> bool { cfg!(feature = "project-v5") }

#[tauri::command(async)]
pub fn checkpoint_project_v5(state: State<'_, AppState>, epoch: u64, expected_revision: u64) -> Result<bool, AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state).checkpoint(epoch, expected_revision)
}

#[tauri::command(async)]
pub fn capture_project_data_snapshot(app:AppHandle,state:State<'_,AppState>,context:ProjectWriteContext,id:String,name:String,created_at:String)->Result<crate::models::project_persistence::ProjectCommit<crate::models::project_persistence::ProjectDataSnapshotDescriptor>,AppError> {
    let db=crate::services::project_native_service::NativeProjectService::new(&state).database(context.expected_epoch)?;
    let progress=|dataset_index,dataset_total,dataset_name:&str|{let _=app.emit("snapshot-progress",serde_json::json!({"datasetIndex":dataset_index,"datasetTotal":dataset_total,"datasetName":dataset_name}));};
    let commit=db.capture_data_snapshot_with_progress(&context,&id,&name,&created_at,&progress)?;
    if app.emit("project-committed",&commit).is_err(){eprintln!("project_commit_event_delivery_failed");}Ok(commit)
}
#[tauri::command(async)]
pub fn list_project_data_snapshots(state:State<'_,AppState>,epoch:u64,after:Option<String>,limit:usize)->Result<crate::models::project_persistence::ProjectDataSnapshotPage,AppError> {
    crate::services::project_native_service::NativeProjectService::new(&state).database(epoch)?.list_data_snapshots(epoch,after.as_deref(),limit)
}
#[tauri::command(async)]
pub fn restore_project_data_snapshot(app:AppHandle,state:State<'_,AppState>,context:ProjectWriteContext,id:String,expected_revision:u64)->Result<crate::models::project_persistence::ProjectCommit<crate::models::project_persistence::ProjectDataSnapshotRestored>,AppError> {
    let db=crate::services::project_native_service::NativeProjectService::new(&state).database(context.expected_epoch)?;
    let progress=|dataset_index,dataset_total,dataset_name:&str|{let _=app.emit("restore-progress",serde_json::json!({"datasetIndex":dataset_index,"datasetTotal":dataset_total,"datasetName":dataset_name}));};
    let commit=db.restore_data_snapshot_with_progress(&context,&id,expected_revision,&progress)?;
    if app.emit("project-committed",&commit).is_err(){eprintln!("project_commit_event_delivery_failed");}Ok(commit)
}
#[tauri::command(async)]
pub fn delete_project_data_snapshot(app:AppHandle,state:State<'_,AppState>,context:ProjectWriteContext,id:String,expected_revision:u64)->Result<crate::models::project_persistence::ProjectCommit<()>,AppError> {
    let db=crate::services::project_native_service::NativeProjectService::new(&state).database(context.expected_epoch)?;
    let commit=db.delete_data_snapshot(&context,&id,expected_revision)?;
    if app.emit("project-committed",&commit).is_err(){eprintln!("project_commit_event_delivery_failed");}Ok(commit)
}
