use tauri::State;

use crate::error::AppError;
use crate::models::distribution::{
    BlackBoxCaseV1, CapabilityDescriptorV1, DistributionReportResponse, DistributionRequest,
};
use crate::services::distribution_service::DistributionService;
use crate::state::AppState;

#[tauri::command]
pub fn list_distribution_capabilities(
    state: State<'_, AppState>,
) -> Result<Vec<CapabilityDescriptorV1>, AppError> {
    DistributionService::new(&state).list_distribution_capabilities()
}

#[tauri::command]
pub fn validate_black_box_case(
    state: State<'_, AppState>,
    case: BlackBoxCaseV1,
) -> Result<(), AppError> {
    DistributionService::new(&state).validate_black_box_case(&case)
}

#[tauri::command]
pub async fn compute_distribution_report(
    state: State<'_, AppState>,
    request: DistributionRequest,
) -> Result<DistributionReportResponse, AppError> {
    DistributionService::new(&state).compute_distribution_report(&request)
}

#[cfg(test)]
mod tests {
    #[test]
    fn distribution_report_uses_one_async_command() {
        let source = include_str!("distribution_commands.rs");

        assert!(source.contains("pub async fn compute_distribution_report"));
        for legacy_command in ["start", "execute", "cancel"] {
            assert!(!source.contains(&format!("{legacy_command}_distribution_run")));
        }
    }
}
