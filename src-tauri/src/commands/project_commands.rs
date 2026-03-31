use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::models::project::ProjectInfo;
use crate::services::project_service::{ProjectService, OpenProjectResult};
use crate::state::AppState;

#[tauri::command]
pub fn init_project(state: State<'_, AppState>) -> Result<ProjectInfo, AppError> {
    let service = ProjectService::new(&state);
    service.init_project()
}

#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    name: String,
    file_path: String,
) -> Result<ProjectInfo, AppError> {
    let service = ProjectService::new(&state);
    service.create_project(&name, &file_path)
}

#[tauri::command]
pub fn open_project(
    state: State<'_, AppState>,
    app: AppHandle,
    file_path: String,
) -> Result<OpenProjectResult, AppError> {
    let service = ProjectService::new(&state);
    service.open_project(&file_path, Some(&|ds_idx, ds_total, ds_name| {
        let _ = app.emit("open-project-progress", serde_json::json!({
            "datasetIndex": ds_idx,
            "datasetTotal": ds_total,
            "datasetName": ds_name,
        }));
    }))
}

#[tauri::command]
pub fn save_project(
    state: State<'_, AppState>,
    file_path: Option<String>,
    history: Option<Vec<serde_json::Value>>,
    snapshots: Option<Vec<serde_json::Value>>,
) -> Result<ProjectInfo, AppError> {
    let service = ProjectService::new(&state);
    service.save_project(file_path.as_deref(), history, snapshots)?;
    // Return updated project info
    service.get_current_project()?.ok_or_else(|| AppError::InvalidParam("No project".into()))
}

#[tauri::command]
pub fn get_current_project(state: State<'_, AppState>) -> Result<Option<ProjectInfo>, AppError> {
    let service = ProjectService::new(&state);
    service.get_current_project()
}
