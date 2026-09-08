use crate::error::AppError;
use crate::models::hypothesis_test::{HypothesisTestRequest, HypothesisTestResponse};
use crate::services::hypothesis_test_service::HypothesisTestService;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn run_hypothesis_test(
    state: State<'_, AppState>,
    request: HypothesisTestRequest,
) -> Result<HypothesisTestResponse, AppError> {
    HypothesisTestService::new(&state).run(request)
}

#[cfg(test)]
mod tests {
    #[test]
    fn command_is_registered_as_a_service_delegate() {
        let source = include_str!("hypothesis_test_commands.rs");
        assert!(source.contains("request: HypothesisTestRequest"));
        assert!(source.contains("Result<HypothesisTestResponse, AppError>"));
        assert!(source.contains("HypothesisTestService::new(&state).run(request)"));

        let lib_source = include_str!("../lib.rs");
        assert!(lib_source.contains(
            "commands::hypothesis_test_commands::run_hypothesis_test,"
        ));
    }
}