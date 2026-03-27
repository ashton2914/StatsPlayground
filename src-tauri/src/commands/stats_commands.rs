use tauri::State;

use crate::error::AppError;
use crate::models::stats::{ColumnStats, DescriptiveResult};
use crate::services::stats_service::StatsService;
use crate::state::AppState;

#[tauri::command]
pub fn get_column_stats(
    state: State<'_, AppState>,
    dataset_id: String,
    column_name: String,
) -> Result<ColumnStats, AppError> {
    let service = StatsService::new(&state);
    service.get_column_stats(&dataset_id, &column_name)
}

#[tauri::command]
pub fn get_descriptive_stats(
    state: State<'_, AppState>,
    dataset_id: String,
) -> Result<DescriptiveResult, AppError> {
    let service = StatsService::new(&state);
    service.get_descriptive_stats(&dataset_id)
}
