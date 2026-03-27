use tauri::State;

use crate::error::AppError;
use crate::services::io_service::IoService;
use crate::state::AppState;

#[tauri::command]
pub fn export_csv(
    state: State<'_, AppState>,
    dataset_id: String,
    output_path: String,
) -> Result<(), AppError> {
    let service = IoService::new(&state);
    service.export_csv(&dataset_id, &output_path)
}
